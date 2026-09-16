import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * AC-16 — an unhandled render error must show a readable fallback,
 * never an empty white screen.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local-first: log to the console only. Nothing is sent anywhere.
    console.error("Unhandled error in application shell:", error, info);
  }

  private readonly handleReload = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-full w-full items-center justify-center bg-background p-8"
      >
        <div className="w-full max-w-md rounded-md border bg-card p-5 text-card-foreground">
          <h1 className="text-sm font-semibold">界面出现错误</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            应用程序外壳遇到未处理的错误。原始 PDF 未受影响。
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded border bg-muted p-2 text-2xs text-muted-foreground">
            {error.message}
          </pre>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={this.handleReload}
          >
            重试
          </Button>
        </div>
      </div>
    );
  }
}
