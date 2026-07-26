---
name: delegated-write
description: Verify that a plugin skill can delegate one exact write to its plugin subagent.
allowed-tools: Agent
---

# Delegated write acceptance fixture

The user message supplies an absolute output file and an exact marker.

You must invoke the `blackbox-trace-plugin:trace-worker` subagent with both values. The subagent, not the main agent, must use the Write tool to create the output file with exactly the marker and one trailing newline. Do not use Write, Edit, or Bash in the main agent. After the subagent reports success, reply `PLUGIN_SUBAGENT_SMOKE_COMPLETE`.
