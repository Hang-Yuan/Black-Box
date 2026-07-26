import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DesktopPet } from "./components/desktop-pet/DesktopPet";
import { DesktopPetStateBridge } from "./components/desktop-pet/DesktopPetStateBridge";
import { bootstrapAppearance } from "./lib/appearance";

bootstrapAppearance();
const isDesktopPetWindow = new URLSearchParams(window.location.search).has("desktop-pet");
if (isDesktopPetWindow) {
  document.documentElement.classList.add("desktop-pet-document");
  document.body.classList.add("desktop-pet-document");
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  handleClearAndReload = () => {
    try {
      localStorage.removeItem("blackbox-settings");
      localStorage.removeItem("blackbox_custom_previews");
    } catch {
      // ignore
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            background: "var(--color-bg-chat)",
            color: "var(--color-text-primary)",
            padding: 32,
            textAlign: "center",
          }}
        >
          <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: "var(--color-text-muted)", fontSize: 14, marginBottom: 24, maxWidth: 480 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={this.handleReload}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                border: "1px solid var(--color-border-subtle)",
                background: "var(--color-bg-card)",
                color: "var(--color-text-primary)",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Retry
            </button>
            <button
              onClick={this.handleClearAndReload}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                border: "none",
                background: "var(--color-accent)",
                color: "var(--color-text-inverse)",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Clear data & Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isDesktopPetWindow ? (
        <DesktopPet />
      ) : (
        <>
          <DesktopPetStateBridge />
          <App />
        </>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
