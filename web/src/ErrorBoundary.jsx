import { Component } from 'react';

// Catches render/runtime errors in a view so a crash shows a readable,
// recoverable message instead of a blank white screen. Reset it by changing
// the `resetKey` prop (e.g. when the user navigates to another view).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // surface it for anyone with the console open
    console.error('view crashed:', error, info);
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h2>Something went wrong on this screen.</h2>
          <p>
            This is usually a cached older version of the app. A hard refresh
            (<kbd>⌘⇧R</kbd> / <kbd>Ctrl-Shift-R</kbd>) normally fixes it.
          </p>
          <pre className="crash-detail">{String(this.state.error && this.state.error.message)}</pre>
          <button className="run" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
