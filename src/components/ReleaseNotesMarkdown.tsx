import { lazy, Suspense } from "react";

const ReleaseNotesMarkdownRenderer = lazy(
  () => import("./ReleaseNotesMarkdownRenderer"),
);

interface ReleaseNotesMarkdownProps {
  children: string;
  className?: string;
}

function ReleaseNotesMarkdown({
  children,
  className,
}: ReleaseNotesMarkdownProps) {
  const classes = ["release-notes-markdown", className]
    .filter(Boolean)
    .join(" ");

  return (
    <Suspense
      fallback={
        <div className={`${classes} release-notes-markdown-fallback`}>
          {children}
        </div>
      }
    >
      <ReleaseNotesMarkdownRenderer className={classes}>
        {children}
      </ReleaseNotesMarkdownRenderer>
    </Suspense>
  );
}

export default ReleaseNotesMarkdown;
