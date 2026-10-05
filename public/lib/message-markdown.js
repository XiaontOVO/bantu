import MarkdownIt from '../vendor/markdown-it/markdown-it.js';

// 回复只生成排版，不允许模型插入 HTML、图片请求或可执行链接。
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true }).disable('image');
markdown.renderer.rules.table_open = () => '<div class="message-table" tabindex="0" role="region" aria-label="回复中的表格"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';
const defaultLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLink ? defaultLink(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
};

export function renderMessageMarkdown(text) {
  return markdown.render(String(text ?? ''));
}
