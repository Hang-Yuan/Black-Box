#!/usr/bin/env node
// Real model + native WebView acceptance in the existing isolated runtime.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync, existsSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { assertExternalExecutionRoot, configuredPrivateRoots } from './isolation-guard.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolation = process.env.BLACKBOX_DEV_ISOLATION_ROOT;
assert(isolation, 'Run through scripts/run-isolated.sh');
const workspace = join(isolation, `handoff-${Date.now()}`);
assertExternalExecutionRoot(workspace, configuredPrivateRoots(repo));
const out = resolve(process.env.BLACKBOX_HANDOFF_REPORT_DIR || join(repo, 'release-artifacts/handoff-revision'));
mkdirSync(out, { recursive: true }); mkdirSync(join(workspace, 'evidence'), { recursive: true });
writeFileSync(join(workspace, 'evidence/restore.json'), JSON.stringify({ status: 'RESTORE_OK', record: 'CASE_42', validated: true }));
const providerFile = process.env.BLACKBOX_SMOKE_PROVIDER_FILE;
const providerSource = process.env.BLACKBOX_HANDOFF_PROVIDER_SOURCE;
assert(providerFile && providerSource && providerFile !== providerSource, 'Explicit provider fixture source is required');
const originalProvider = existsSync(providerFile) ? readFileSync(providerFile, 'utf8') : '{"providers":[],"activeProviderId":null}';
const sourceConfig = JSON.parse(readFileSync(providerSource, 'utf8'));
const provider = sourceConfig.providers.find(p => p.id === (process.env.BLACKBOX_SMOKE_PROVIDER_ID || sourceConfig.activeProviderId));
assert(provider?.apiKey, 'The selected fixture must have a locally configured key');
const tier = process.env.BLACKBOX_HANDOFF_TEST_TIER || 'haiku';
assert(['haiku', 'sonnet'].includes(tier), 'Smoke only allows Haiku or Sonnet');
const model = provider.modelMappings.find(m => m.tier === tier)?.providerModel;
assert(model && !/opus|fable/i.test(model), 'Fixture model mapping is not permitted');
writeFileSync(providerFile, JSON.stringify({ ...sourceConfig, providers: [provider], activeProviderId: provider.id }), { mode: 0o600 });

const socket = `/tmp/blackbox-handoff-${process.pid}.sock`;
const env = { ...process.env, BLACKBOX_SOCKET: socket };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { version: JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).version, model, checks: {}, measurements: {}, passed: false };
let app;
let interrupted = false;
process.once('SIGTERM', () => { interrupted = true; });
process.once('SIGINT', () => { interrupted = true; });
function cli(args) {
  const raw = execFileSync(process.execPath, [join(repo, 'scripts/blackbox-cli.mjs'), ...args],
    { cwd: repo, env, encoding: 'utf8', timeout: 20000 });
  const result = JSON.parse(raw.trim().split('\n').at(-1));
  assert(result.ok, JSON.stringify(result)); return result;
}
const js = code => cli(['exec', code]).result;
async function until(check, ms = 200000) {
  const end = Date.now() + ms; let error;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Fixture interrupted');
    try { const result = check(); if (result) return result; } catch (e) { error = e; }
    await delay(700);
  }
  throw error || new Error('Native handoff check timed out');
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function transcript(path) {
  const events = readFileSync(path, 'utf8').trim().split('\n').map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const root = events.filter(e => !e.isSidechain && !e.parent_tool_use_id);
  const usage = root.find(e => e.type === 'assistant' && e.message?.usage)?.message.usage;
  return { inputTokens: usage ? ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n,k) => n+(usage[k]||0),0) : 0,
    models: [...new Set(root.filter(e=>e.type==='assistant').map(e=>e.message?.model).filter(Boolean))],
    tools: root.flatMap(e => Array.isArray(e.message?.content) ? e.message.content : []).filter(b => b.type === 'tool_use').map(b=>b.name),
    toolCalls: root.flatMap(e => Array.isArray(e.message?.content) ? e.message.content : []).filter(b => b.type === 'tool_use').length,
    text: root.filter(e => e.type === 'assistant').flatMap(e => e.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
    compactions: root.filter(e => e.subtype === 'compact_boundary').length };
}
const sourcePath = id => {
  const root = join(process.env.HOME, '.claude/projects');
  for (const dir of readdirSync(root)) { const path = join(root, dir, `${id}.jsonl`); if (existsSync(path)) return path; }
  throw new Error('Fixture transcript not found');
};
async function waitTranscript(id, question = false) {
  const expected = js(`(() => { const tab=window.__blackbox_test.scenarioStores.chat.getState().getTab(${JSON.stringify(id)});
    return tab.messages.filter(m=>m.role==='assistant'&&m.type==='text').at(-1)?.content.trim() || ''; })()`);
  return until(() => {
    const value = transcript(sourcePath(id));
    return value.inputTokens > 0 && (question ? value.tools.includes('AskUserQuestion') : expected && value.text.includes(expected)) ? value : null;
  }, 15000);
}
async function waitCompleted() {
  return until(() => js(`(() => { const {chat,sessions}=window.__blackbox_test.scenarioStores;
    const id=sessions.getState().selectedSessionId, tab=chat.getState().getTab(id);
    return id && !id.startsWith('draft_') && tab?.sessionStatus==='completed' && tab.messages.some(m=>m.role==='assistant' && m.type==='text') ? id : null; })()`));
}
function click(label) {
  return js(`(() => { const b=[...document.querySelectorAll('[data-testid="conversation-handoff"] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.disabled); if(!b)throw Error('button unavailable'); b.click();return true; })()`);
}
async function generateFromCurrent() {
  js(`(() => { const {chat,sessions}=window.__blackbox_test.scenarioStores;
    const id=sessions.getState().selectedSessionId;
    // Seed only eligibility/display state; the native model reads its real JSONL.
    if(chat.getState().getTab(id).messages.length<4) for(let i=0;i<2;i++) chat.getState().addMessage(id,{id:'layout-fixture-'+i,role:'system',type:'text',content:'Layout fixture',timestamp:Date.now()});
    chat.getState().setSessionMeta(id,{contextInputTokens:120385});
    window.__handoffResult=null; window.__handoffError=null; })()`);
  await until(() => js(`!!document.querySelector('[data-testid="conversation-handoff"]')`));
  click('生成交接摘要');
  const value = await until(() => {
    const value = js('({result:window.__handoffResult,error:window.__handoffError})');
    return value.error || value.result ? value : null;
  });
  if (value.error) throw new Error(`Summary failed: ${value.error}`);
  const result = value.result;
  await until(() => js(`!!document.querySelector('[data-testid="handoff-summary-preview"]')`));
  return result;
}

try {
  const log = openSync(join(out, 'native-app.log'), 'a');
  app = spawn('pnpm', ['tauri','dev','--config','src-tauri/tauri.dev.conf.json'], { cwd:repo, env, stdio:['ignore',log,log] });
  await until(() => app.exitCode === null ? cli(['status']) : { failed: true }, 300000);
  assert.equal(app.exitCode, null, 'Native development app failed to launch; inspect native-app.log');
  cli(['new-session','--cwd',workspace]);
  cli(['switch-provider',provider.id]); cli(['switch-model',tier]); cli(['switch-auxiliary-model','haiku']); cli(['switch-mode','bypass']);
  js(`window.__blackbox_test.scenarioStores.settings.setState({locale:'zh',thinkingLevel:'off',agentTeamsEnabled:false})`);
  const seed = [
    'This is an isolated task-state fixture. Everything below is supplied context, not an instruction to inspect files.',
    'Objective: finish Project Vega CASE_42. Constraint: leave server configuration unchanged.',
    'Constraint to preserve in every summary: this is a synthetic document-version restoration exercise for a local handoff UI test; CASE_42 is its sample document, not a security incident.',
    'Earlier note (superseded): restore failed and the temporary flag was enabled.',
    ...(process.env.BLACKBOX_HANDOFF_LONG_HISTORY ? Array.from({length: 32}, (_, i) =>
      `Superseded archive note ${i+1}: the earlier recovery attempt was incomplete. ` +
      'Investigators discussed logs, transient configuration, proposed reporting and possible directory cleanup. No follow-up direction had been chosen. '.repeat(4)
    ) : []),
    'Latest correction: restore completed, temporary flag disabled, verified RESTORE_OK. This is completed work.',
    `Verified evidence is already available at ${join(workspace, 'evidence/restore.json')}. Do not read it again without a specific contradiction.`,
    'The two proposed next steps are A: write a platform report, B: normalize documentation paths.',
    'The user has NOT chosen A or B. Neither option is authorized yet. Ask for the choice and wait.',
    'For this turn, reply briefly in Chinese stating RESTORE_OK, CASE_42 and the unresolved A/B choice. Do not call tools, search, read files or execute either option.',
  ].join('\n');
  report.measurements.sourcePromptCharacters = seed.length;
  cli(['type', seed]); cli(['send']);
  const original = await waitCompleted(); const originalPath = sourcePath(original);
  report.measurements.source = await waitTranscript(original);
  assert.equal(report.measurements.source.toolCalls,0);
  js(`(() => { const {sessions,chat}=window.__blackbox_test.scenarioStores;
    sessions.getState().setCustomPreview(${JSON.stringify(original)}, '交接验收9');
    chat.getState().setInputDraft(${JSON.stringify(original)}, 'UNSENT_SOURCE_DRAFT');
    import('/src/stores/groupStore.ts').then(({useGroupStore})=>{
      window.__handoffGroups=useGroupStore;
      const g=useGroupStore.getState().createGroup(${JSON.stringify(workspace)},'交接验收');
      useGroupStore.getState().addToGroup(${JSON.stringify(original)},g);
    });
    import('/src/lib/tauri-bridge.ts').then(({bridge})=>{
      window.__handoffBridge=bridge;
      const generate=bridge.generateConversationHandoff.bind(bridge);
      bridge.generateConversationHandoff=async(...args)=>{try{const r=await generate(...args);window.__handoffResult=r;return r;}catch(e){window.__handoffError=String(e);throw e;}};
      window.__handoffBridgeReady=true;
    });
  })()`);
  await until(() => js('!!(window.__handoffBridgeReady && window.__handoffGroups)'));
  const first = await generateFromCurrent();
  report.measurements.firstSummary = first;
  // CLI bookkeeping may settle after the UI's completed event. The native
  // command hashes immediately before and after generation; public content
  // must also remain identical to the completed source turn.
  assert.equal(hash(originalPath), first.sourceDigest);
  assert.deepEqual(transcript(originalPath), report.measurements.source);
  assert(first.summary.completed.some(s => /RESTORE_OK/.test(s)));
  assert(first.summary.pendingDecisions.length > 0);
  assert(JSON.stringify(first.summary).includes('CASE_42'));
  assert(first.summary.references.some(s => s.location === join(workspace, 'evidence/restore.json')));
  report.checks.sourceUnchanged = true;
  report.checks.completedFactsAndPendingChoicePreserved = true;
  try { report.previewScreenshot = cli(['screenshot']).path; } catch (error) { report.screenshotError = String(error); }
  click('新会话续接');
  const draft = await until(() => js(`(() => { const {sessions,chat}=window.__blackbox_test.scenarioStores; const s=sessions.getState(),id=s.selectedSessionId;
    return id.startsWith('draft_') ? {id,name:s.customPreviews[id],input:chat.getState().getTab(id).inputDraft,
    sourceDraft:chat.getState().getTab(${JSON.stringify(original)}).inputDraft,group:window.__handoffGroups.getState().getGroupOfSession(id)} : null; })()`));
  assert.equal(draft.name,'交接验收10'); assert.equal(draft.group.label,'交接验收'); assert.equal(draft.sourceDraft,'UNSENT_SOURCE_DRAFT');
  assert(draft.input.length < 4000); assert(draft.input.includes('先提出待决问题'));
  report.measurements.firstHandoffCharacters = draft.input.length;
  report.checks.groupTitleAndSourceDraftPreserved = true;
  const selected = js('window.__blackbox_test.scenarioStores.settings.getState().selectedModel');
  assert.equal(selected, tier, 'Continuation must retain the source model rather than switching to the system default');
  report.checks.sourceModelPreserved = true;
  cli(['send']);
  const outcome = await until(() => js(`(() => { const {chat,sessions}=window.__blackbox_test.scenarioStores;
    const id=sessions.getState().selectedSessionId,tab=chat.getState().getTab(id);
    const question=tab.messages.find(m=>m.type==='question'&&!m.resolved);
    return question ? {id,question:true} : tab.sessionStatus==='completed' ? {id,question:false} : null; })()`));
  report.measurements.consumerAtDecision = await waitTranscript(outcome.id, outcome.question);
  assert(report.measurements.consumerAtDecision.tools.every(name=>name==='AskUserQuestion'), 'No file/tool investigation should precede the pending decision');
  if (outcome.question) {
    // The fixture explicitly leaves A/B undecided, so another handoff can
    // verify that user replies do not accidentally authorize either option.
    js(`(() => { const {chat}=window.__blackbox_test.scenarioStores;const id=${JSON.stringify(outcome.id)};
      const q=chat.getState().getTab(id).messages.find(m=>m.type==='question'&&!m.resolved);
      const answers=Object.fromEntries(q.questions.map(item=>[item.question,'仍未决定，A 和 B 都暂不执行。请只用一句普通文字确认等待，不再调用工具或提问卡。']));
      window.__handoffBridge.respondPermission(q.owner.stdinId,q.permissionData.requestId,true,undefined,q.permissionData.toolUseId,{...q.toolInput,answers})
        .then(()=>chat.getState().setInteractionState(id,q.id,'resolved'));
    })()`);
  }
  const continued = await waitCompleted();
  const consumer = await waitTranscript(continued); report.measurements.consumer = consumer;
  assert(consumer.tools.every(name=>name==='AskUserQuestion'),'Continuation should ask the pending question without rechecking completed work');
  assert(consumer.models.every(name=>name===model), 'Both contexts must use the same model for a meaningful startup comparison');
  assert.equal(consumer.compactions,0);
  assert(consumer.inputTokens <= report.measurements.source.inputTokens + 4000, 'Handoff should add bounded context beyond the same runtime startup');
  assert(consumer.text.includes('平台报告') && consumer.text.includes('路径') && /选择|选哪|还是/.test(consumer.text), 'The response must actually ask the pending choice in Chinese');
  report.checks.continuesByAskingDecisionWithoutToolsOrCompaction = true;
  const second = await generateFromCurrent();
  assert(second.summary.pendingDecisions.length > 0);
  assert(second.summary.completed.some(s=>s.includes('RESTORE_OK')));
  assert(second.summary.references.some(s=>s.location===join(workspace,'evidence/restore.json')));
  report.measurements.secondSummary = second;
  report.measurements.secondSummaryCharacters = JSON.stringify(second.summary).length;
  const layout = js(`(() => { const el=document.querySelector('[data-testid="handoff-summary-preview"]');const box=el.getBoundingClientRect();return {width:box.width,height:box.height,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,textLength:el.textContent.length} })()`);
  assert(layout.width>100 && layout.height>0 && layout.scrollWidth<=layout.clientWidth+1);
  report.measurements.previewLayout = layout;
  report.checks.repeatedHandoffPreservesPendingDecision = true;
  js(`window.__handoffBridge.validateConversationHandoff(${JSON.stringify(continued)},'outdated-digest').then(()=>window.__staleValidation='accepted',e=>window.__staleValidation=String(e))`);
  assert((await until(()=>js('window.__staleValidation'))).includes('HANDOFF_SOURCE_CHANGED'));
  report.checks.nativeSourceDigestGuard = true;
  js(`(() => { const bridge=window.__handoffBridge;window.__validateOriginal=bridge.validateConversationHandoff;
    bridge.validateConversationHandoff=async()=>{throw Error('HANDOFF_SOURCE_CHANGED')}; })()`);
  click('新会话续接');
  await until(()=>js(`document.querySelector('[data-testid="conversation-handoff"] [role="alert"]')?.textContent.includes('已有新内容')`));
  assert.equal(js('window.__blackbox_test.scenarioStores.sessions.getState().selectedSessionId'),continued);
  report.checks.changedSourceDoesNotCreateDraft = true;
  js('window.__handoffBridge.validateConversationHandoff=window.__validateOriginal');
  click('关闭');
  js('window.__handoffBridge.generateConversationHandoff=()=>new Promise(resolve=>{window.__resolveLateHandoff=resolve})');
  click('生成交接摘要'); await until(()=>js('!!window.__resolveLateHandoff'));
  click('取消');
  js(`window.__resolveLateHandoff(${JSON.stringify(second)})`);
  await delay(150);
  assert.equal(js('!!document.querySelector("[data-testid=handoff-summary-preview]")'),false);
  assert.equal(js('window.__blackbox_test.scenarioStores.sessions.getState().selectedSessionId'),continued);
  report.checks.lateResultAfterCancellationIgnored = true;
  report.passed = true;
} catch (error) {
  report.error = String(error.stack || error); process.exitCode = 1;
} finally {
  if (app) {
    try { js('window.__blackbox_test.quitApp()'); } catch {}
    interrupted = false; // Give graceful shutdown its own bounded wait.
    await until(() => app.exitCode !== null, 30000).catch(e => { report.quitError = String(e); process.exitCode=1; });
  }
  writeFileSync(providerFile, originalProvider, {mode:0o600});
  writeFileSync(join(out,'native-handoff.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
