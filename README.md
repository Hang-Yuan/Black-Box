<div align="center">

<img src="public/app-icon.png" alt="Black Box Logo" width="120" />

# Black Box

A desktop GUI client for Claude Code CLI.

[![License](https://img.shields.io/badge/license-Apache%202.0-green?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)

**[English](README.md)** | **[中文](README_zh.md)**

</div>

## Overview

Black Box wraps the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) in a native desktop app — file explorer, session management, streaming chat, and structured permission control in one window.

## Build from Source

### Prerequisites

- Node.js 20+
- pnpm
- Rust (via [rustup](https://rustup.rs))
- Platform SDKs: Xcode CLT (macOS) / Visual Studio Build Tools with C++ (Windows) / WebKit2GTK (Linux)

### Steps

```bash
pnpm install
pnpm tauri build    # production build → installer in src-tauri/target/release/bundle/
pnpm tauri dev      # dev mode with hot reload
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri 2 |
| Frontend | React 19 + TypeScript |
| Styling | Tailwind CSS 4 |
| State | Zustand 5 |
| Editor | CodeMirror 6 |
| Bundler | Vite 7 |
| Backend | Rust |

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Acknowledgments

Black Box retains the copyright and license notices required by its Apache-2.0-licensed foundations.
</div>
