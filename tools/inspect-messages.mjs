// Find message article selectors inside the thread for per-message readability backing.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const thread = document.querySelector('[container-name="thread-content"], [class*="thread"]');
  // message rows: look for article tags and data attributes
  const articles = [...document.querySelectorAll('main article')].slice(0, 4).map((a) => ({
    cls: a.className.slice(0, 140),
    children: a.children.length,
    bg: getComputedStyle(a).backgroundColor,
  }));
  // user message bubbles
  const userBubble = document.querySelector('[class*="user-message"], [data-message-author-role="user"]');
  // assistant text
  const assistant = document.querySelector('[data-message-author-role="assistant"], main .markdown');
  const roles = [...document.querySelectorAll('[data-message-author-role]')].slice(0, 6).map((e) => e.getAttribute('data-message-author-role'));
  const threadContainers = [...document.querySelectorAll('main [class*="thread"], main [class*="Thread"], main [class*="conversation"], main [class*="Conversation"]')]
    .slice(0, 8).map((e) => e.className.slice(0, 120));
  return {
    articleCount: document.querySelectorAll('main article').length,
    articles,
    userBubbleCls: userBubble ? userBubble.className.slice(0, 140) : null,
    userBubbleBg: userBubble ? getComputedStyle(userBubble).backgroundColor : null,
    assistantCls: assistant ? assistant.className.slice(0, 100) : null,
    roles,
    threadContainers,
    markdownCount: document.querySelectorAll('main .markdown').length,
  };
})()`;

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
console.log(JSON.stringify(r.result.value ?? r, null, 2));
c.close();
