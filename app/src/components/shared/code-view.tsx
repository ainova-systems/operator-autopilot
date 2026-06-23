import { cn } from "@/lib/cn";

interface CodeBlockProps {
  readonly content: string;
  readonly className?: string;
  readonly wrap?: boolean;
}

export function CodeBlock({
  content,
  className,
  wrap = true,
}: CodeBlockProps): React.ReactElement {
  return (
    <pre
      className={cn(
        "m-0 rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed",
        wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto",
        className,
      )}
    >
      {content}
    </pre>
  );
}
