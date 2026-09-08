import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { postToHost } from './vscode';

/** Render prose as React elements. Code fences keep their existing disclosure
 * in ChatPanel; model HTML and remote images must never execute or load here. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="hps-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => /^https?:\/\//i.test(href ?? '')
            ? <a href={href} onClick={event => { event.preventDefault(); postToHost({ type: 'openExternal', url: href! }); }}>{children}</a>
            : <span>{children}</span>,
          // A model-supplied image URL is not authorization to fetch it.
          img: ({ alt }) => <span>{alt ? `[이미지: ${alt}]` : '[이미지]'}</span>,
          table: ({ children }) => <div className="hps-markdown-table"><table>{children}</table></div>,
          input: ({ checked }) => <span aria-label={checked ? '완료 항목' : '미완료 항목'}>{checked ? '☑' : '☐'}</span>,
        }}
      >{text}</Markdown>
    </div>
  );
}
