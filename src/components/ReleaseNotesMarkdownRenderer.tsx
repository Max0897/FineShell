import type { MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openApplicationUrl } from "../app-updater";

interface ReleaseNotesMarkdownRendererProps {
  children: string;
  className: string;
}

function ReleaseNotesMarkdownRenderer({
  children,
  className,
}: ReleaseNotesMarkdownRendererProps) {
  const openLink = (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
    if (!href) return;
    event.preventDefault();
    void openApplicationUrl(href);
  };

  return (
    <div className={className}>
      <ReactMarkdown
        components={{
          a: ({ children: linkChildren, href }) => (
            <a href={href} onClick={(event) => openLink(event, href)}>
              {linkChildren}
            </a>
          ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default ReleaseNotesMarkdownRenderer;
