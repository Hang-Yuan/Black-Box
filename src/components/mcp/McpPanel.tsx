// Legacy secondary-panel entrypoint. The settings implementation is now the
// single MCP management surface so scope, transport, approval, and OAuth state
// cannot drift between two copies of the UI.
export { McpTab as McpPanel } from '../settings/McpTab';
