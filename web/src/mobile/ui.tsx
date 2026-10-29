/**
 * Shared mobile UI atoms. Deliberately small and dependency-free so each
 * screen composes the same touch targets, glass surfaces and sheets.
 */
import { useEffect, type ReactNode } from "react";

export function ScreenHeader({
  eyebrow,
  title,
  right,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="m-eyebrow">{eyebrow}</div>
        <h1 className="m-title mt-1 truncate">{title}</h1>
        {subtitle ? <div className="m-small mt-1.5">{subtitle}</div> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2 pt-1">{right}</div> : null}
    </header>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="m-section">
      <div className="m-section-head">
        <span className="m-label">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`m-card m-card-pad ${className ?? ""}`}>{children}</div>;
}

export function Row({
  title,
  subtitle,
  right,
  onClick,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="m-row-main">
        <div className="m-row-title">{title}</div>
        {subtitle ? <div className="m-row-sub">{subtitle}</div> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="m-row w-full text-left" onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className="m-row">{content}</div>;
}

export function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="m-row">
      <div className="m-row-main">
        <div className="m-row-title">{label}</div>
        {hint ? <div className="m-row-sub">{hint}</div> : null}
      </div>
      <button
        type="button"
        className="m-toggle"
        data-on={value}
        role="switch"
        aria-checked={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!value)}
      >
        <span />
      </button>
    </div>
  );
}

export function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "danger" | "accent";
}) {
  return (
    <span className="m-chip" data-tone={tone}>
      {children}
    </span>
  );
}

export function Sheet({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="m-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="m-sheet">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="m-label">{title}</span>
          <button type="button" className="m-btn" data-variant="ghost" data-size="sm" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="m-card m-card-pad text-center">
      <div className="m-h2">{title}</div>
      <p className="m-small mt-2">{body}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function StatusLine({
  state,
  label,
  detail,
}: {
  state: "online" | "offline" | "checking" | "idle";
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="m-dot" data-state={state} />
      <span className="m-small" style={{ color: "rgba(232,244,255,0.86)" }}>
        {label}
      </span>
      {detail ? <span className="m-row-sub ml-auto text-right">{detail}</span> : null}
    </div>
  );
}
