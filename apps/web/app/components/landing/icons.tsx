/**
 * Inline icons — avoids pulling an icon library into the bundle.
 *
 * Each icon carries width/height attributes as a hard floor. `className`
 * replaces the default, so a caller passing only e.g. transition classes would
 * otherwise leave the SVG unsized and it would stretch to fill its flex parent.
 */

type IconProps = { className?: string };

const base = "h-5 w-5";

type SvgProps = IconProps & { children: React.ReactNode; size?: number };

function Svg({ className = base, size = 20, children }: SvgProps) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function BugIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 6a4 4 0 1 1 8 0" strokeLinecap="round" />
      <rect x="6" y="8" width="12" height="12" rx="6" />
      <path d="M3 12h3M18 12h3M4 17l2.5-1.5M17.5 15.5 20 17M4 8l2.5 1.5M17.5 9.5 20 8" strokeLinecap="round" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" strokeLinejoin="round" />
      <path d="m3 13 9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function FlaskIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M10 3v6.2L4.6 18A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-3L14 9.2V3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 3h6M7.5 15h9" strokeLinecap="round" />
    </Svg>
  );
}

export function BoltIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" strokeLinejoin="round" />
    </Svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" strokeLinecap="round" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17 14.4A6 6 0 0 1 21 20" strokeLinecap="round" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
    </Svg>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M6.6 7.6 10.6 16M17.4 7.6 13.4 16" strokeLinecap="round" />
    </Svg>
  );
}

export function ArrowRight({ className = "h-4 w-4" }: IconProps) {
  return (
    <Svg className={className} size={16}>
      <path d="M5 12h14M13 6l6 6-6 6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function CheckIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <Svg className={className} size={16}>
      <path d="m5 13 4 4L19 7" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
