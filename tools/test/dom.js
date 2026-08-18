/**
 * A DOM small enough to run this site's page controllers under JavaScriptCore.
 *
 * There is no usable headless browser on this machine — headless Brave hangs on
 * crashpad regardless of flags — and the static checks can only prove that ids
 * and imports line up, not that a page actually runs. This closes that gap: it
 * parses the real HTML file, installs just enough of the browser platform, and
 * lets the real page module execute against it.
 *
 * It is deliberately a shim, not an emulator. It implements the APIs this
 * codebase uses (surveyed, not guessed) and throws loudly on anything it does
 * not, so a gap here shows up as an obvious failure rather than a silent pass.
 */

/* ------------------------------------------------------------------ */
/* HTML parsing                                                       */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

// Elements that cannot contain themselves; a new one closes the open one.
const AUTO_CLOSE = { li: ['li'], option: ['option'], p: ['p'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'] };

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match = pattern.exec(source);
  while (match) {
    const name = match[1].toLowerCase();
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
    match = pattern.exec(source);
  }
  return attributes;
}

/** Parse a fragment into detached nodes. */
export function parseFragment(html) {
  const root = new Element('#fragment');
  let open = [root];
  let index = 0;
  const text = String(html ?? '');

  const appendText = (value) => {
    if (!value) return;
    open[open.length - 1].appendChild(new TextNode(value));
  };

  while (index < text.length) {
    const next = text.indexOf('<', index);
    if (next === -1) {
      appendText(text.slice(index));
      break;
    }
    appendText(text.slice(index, next));

    if (text.startsWith('<!--', next)) {
      const end = text.indexOf('-->', next);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', next)) {
      const end = text.indexOf('>', next);
      index = end === -1 ? text.length : end + 1;
      continue;
    }

    if (text.startsWith('</', next)) {
      const end = text.indexOf('>', next);
      const name = text.slice(next + 2, end).trim().toLowerCase();
      for (let depth = open.length - 1; depth > 0; depth -= 1) {
        if (open[depth].tagName === name) {
          open = open.slice(0, depth);
          break;
        }
      }
      index = end === -1 ? text.length : end + 1;
      continue;
    }

    const end = text.indexOf('>', next);
    if (end === -1) {
      appendText(text.slice(next));
      break;
    }

    let inner = text.slice(next + 1, end);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);

    const space = inner.search(/\s/);
    const name = (space === -1 ? inner : inner.slice(0, space)).toLowerCase();
    const attributes = parseAttributes(space === -1 ? '' : inner.slice(space));

    const closes = AUTO_CLOSE[name];
    if (closes) {
      const parent = open[open.length - 1];
      if (closes.includes(parent.tagName)) open.pop();
    }

    const element = new Element(name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    open[open.length - 1].appendChild(element);

    if (RAW_TEXT_TAGS.has(name)) {
      const closeTag = `</${name}`;
      const rawEnd = text.toLowerCase().indexOf(closeTag, end + 1);
      const raw = text.slice(end + 1, rawEnd === -1 ? text.length : rawEnd);
      if (raw) element.appendChild(new TextNode(raw));
      const after = rawEnd === -1 ? text.length : text.indexOf('>', rawEnd);
      index = after === -1 ? text.length : after + 1;
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(name)) open.push(element);
    index = end + 1;
  }

  return root.childNodes.slice();
}

/* ------------------------------------------------------------------ */
/* selectors                                                          */
/* ------------------------------------------------------------------ */

function parseSimple(part) {
  const test = { tag: null, id: null, classes: [], attrs: [] };
  const pattern = /(^[\w-]+)|#([\w:-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\]/g;
  let match = pattern.exec(part);
  while (match) {
    if (match[1]) test.tag = match[1].toLowerCase();
    else if (match[2]) test.id = match[2];
    else if (match[3]) test.classes.push(match[3]);
    else if (match[4]) test.attrs.push({ name: match[4].toLowerCase(), value: match[6] ?? null });
    match = pattern.exec(part);
  }
  return test;
}

function matchesSimple(element, test) {
  if (test.tag && element.tagName !== test.tag) return false;
  if (test.id && element.getAttribute('id') !== test.id) return false;
  if (test.classes.some((name) => !element.classList.contains(name))) return false;
  return test.attrs.every((attr) => {
    if (!element.hasAttribute(attr.name)) return false;
    return attr.value === null || element.getAttribute(attr.name) === attr.value;
  });
}

/** Compile "#a .b, [data-x]" into a predicate over elements. */
function compile(selector) {
  const groups = String(selector)
    .split(',')
    .map((group) => group.trim().split(/\s+/).map(parseSimple))
    .filter((chain) => chain.length);

  return (element) =>
    groups.some((chain) => {
      const last = chain[chain.length - 1];
      if (!matchesSimple(element, last)) return false;
      // Walk ancestors right-to-left for the descendant combinator.
      let cursor = element.parentNode;
      for (let i = chain.length - 2; i >= 0; i -= 1) {
        let found = false;
        while (cursor) {
          if (cursor instanceof Element && matchesSimple(cursor, chain[i])) {
            found = true;
            cursor = cursor.parentNode;
            break;
          }
          cursor = cursor.parentNode;
        }
        if (!found) return false;
      }
      return true;
    });
}

/* ------------------------------------------------------------------ */
/* nodes                                                             */
/* ------------------------------------------------------------------ */

class Node {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
  }

  appendChild(node) {
    if (node instanceof DocumentFragment) {
      node.childNodes.slice().forEach((child) => this.appendChild(child));
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at !== -1) this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }

  append(...nodes) {
    nodes.forEach((node) =>
      this.appendChild(typeof node === 'string' ? new TextNode(node) : node)
    );
  }

  prepend(...nodes) {
    nodes.reverse().forEach((node) => {
      const value = typeof node === 'string' ? new TextNode(node) : node;
      if (value.parentNode) value.parentNode.removeChild(value);
      value.parentNode = this;
      this.childNodes.unshift(value);
    });
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof Element);
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  contains(node) {
    let cursor = node;
    while (cursor) {
      if (cursor === this) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  /** Depth-first list of descendant elements. */
  descendants() {
    const out = [];
    const walk = (node) => {
      node.childNodes.forEach((child) => {
        if (child instanceof Element) {
          out.push(child);
          walk(child);
        }
      });
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    const test = compile(selector);
    return this.descendants().find(test) || null;
  }

  querySelectorAll(selector) {
    const test = compile(selector);
    return this.descendants().filter(test);
  }

  addEventListener(type, handler) {
    type.split(/\s+/).forEach((name) => {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(handler);
    });
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  /** Dispatch with bubbling, which the delegated click handlers rely on. */
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    let cursor = this;
    while (cursor) {
      event.currentTarget = cursor;
      const handlers = cursor.listeners.get(event.type);
      if (handlers) [...handlers].forEach((handler) => handler.call(cursor, event));
      if (!event.bubbles || event.propagationStopped) break;
      cursor = cursor.parentNode;
    }
    return !event.defaultPrevented;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes.forEach((node) => {
      node.parentNode = null;
    });
    this.childNodes = [];
    if (value !== '' && value != null) this.appendChild(new TextNode(String(value)));
  }
}

class TextNode extends Node {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class DocumentFragment extends Node {
  constructor() {
    super();
    this.nodeType = 11;
  }
}

class ClassList {
  constructor(element) {
    this.element = element;
  }

  get tokens() {
    return String(this.element.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean);
  }

  add(...names) {
    const set = new Set(this.tokens);
    names.forEach((name) => set.add(name));
    this.element.setAttribute('class', [...set].join(' '));
  }

  remove(...names) {
    const set = new Set(this.tokens);
    names.forEach((name) => set.delete(name));
    this.element.setAttribute('class', [...set].join(' '));
  }

  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this.add(name);
    else this.remove(name);
    return want;
  }

  contains(name) {
    return this.tokens.includes(name);
  }
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

class Element extends Node {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.style = new Proxy(
      { cssText: '' },
      {
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      }
    );

    // Layout has no meaning without a renderer, so give charts a plausible box
    // to draw into rather than zero, which would hide divide-by-zero bugs.
    this.clientWidth = 800;
    this.clientHeight = 210;
    this.offsetWidth = 800;
    this.offsetHeight = 210;

    const element = this;
    this.dataset = new Proxy(
      {},
      {
        get(target, key) {
          const value = element.getAttribute(`data-${kebab(String(key))}`);
          return value === null ? undefined : value;
        },
        set(target, key, value) {
          element.setAttribute(`data-${kebab(String(key))}`, String(value));
          return true;
        },
        has(target, key) {
          return element.hasAttribute(`data-${kebab(String(key))}`);
        },
        ownKeys() {
          return [...element.attributes.keys()]
            .filter((name) => name.startsWith('data-'))
            .map((name) => camel(name.slice(5)));
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true };
        },
      }
    );
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  set disabled(value) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get checked() {
    if (this._checked !== undefined) return this._checked;
    return this.hasAttribute('checked');
  }

  set checked(value) {
    this._checked = Boolean(value);
  }

  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'select') {
      const selected = this.querySelectorAll('option').find((option) =>
        option.hasAttribute('selected')
      );
      const first = this.querySelector('option');
      return (selected || first)?.getAttribute('value') ?? '';
    }
    return this.getAttribute('value') ?? '';
  }

  set value(next) {
    this._value = String(next);
  }

  get options() {
    return this.querySelectorAll('option');
  }

  get innerHTML() {
    return this.childNodes.map(serialize).join('');
  }

  set innerHTML(html) {
    this.childNodes.forEach((node) => {
      node.parentNode = null;
    });
    this.childNodes = [];
    parseFragment(html).forEach((node) => this.appendChild(node));
  }

  get outerHTML() {
    return serialize(this);
  }

  insertAdjacentHTML(position, html) {
    const nodes = parseFragment(html);
    if (position === 'beforeend') nodes.forEach((node) => this.appendChild(node));
    else if (position === 'afterbegin') this.prepend(...nodes);
    else throw new Error(`dom shim: insertAdjacentHTML '${position}' not implemented`);
  }

  closest(selector) {
    const test = compile(selector);
    let cursor = this;
    while (cursor) {
      if (cursor instanceof Element && test(cursor)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  matches(selector) {
    return compile(selector)(this);
  }

  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight,
    };
  }

  focus() {}

  blur() {}

  scrollIntoView() {}

  setPointerCapture() {}

  releasePointerCapture() {}

  click() {
    this.dispatchEvent(new SyntheticEvent('click', { bubbles: true }));
  }

  /* dialog */
  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  /* canvas */
  getContext(kind) {
    if (kind !== '2d') return null;
    if (!this._context) this._context = createContext2d();
    return this._context;
  }
}

function serialize(node) {
  if (node instanceof TextNode) return node.data;
  const attributes = [...node.attributes.entries()]
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attributes} />`;
  return `<${node.tagName}${attributes}>${node.childNodes.map(serialize).join('')}</${node.tagName}>`;
}

/** Records every call so a test can assert the chart actually drew something. */
function createContext2d() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return undefined;
  };
  return {
    calls,
    canvas: null,
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    measureText: (text) => ({ width: String(text).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
  };
}

class SyntheticEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles ?? false;
    this.detail = options.detail;
    this.target = options.target || null;
    this.currentTarget = null;
    this.clientX = options.clientX ?? 0;
    this.clientY = options.clientY ?? 0;
    this.pointerId = options.pointerId ?? 1;
    this.pointerType = options.pointerType ?? 'mouse';
    this.buttons = options.buttons ?? 0;
    this.key = options.key ?? '';
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

/* ------------------------------------------------------------------ */
/* URL                                                                */
/* ------------------------------------------------------------------ */

// JavaScriptCore's shell has no URL or URLSearchParams, so both are implemented
// here. Only absolute http(s) URLs and query manipulation are needed.

class ShimSearchParams {
  constructor(init = '') {
    this.pairs = [];
    const text = String(init).replace(/^\?/, '');
    if (text) {
      text.split('&').forEach((chunk) => {
        if (!chunk) return;
        const at = chunk.indexOf('=');
        const key = at === -1 ? chunk : chunk.slice(0, at);
        const value = at === -1 ? '' : chunk.slice(at + 1);
        this.pairs.push([decodeURIComponent(key), decodeURIComponent(value.replace(/\+/g, ' '))]);
      });
    }
  }

  get(key) {
    const found = this.pairs.find(([name]) => name === String(key));
    return found ? found[1] : null;
  }

  getAll(key) {
    return this.pairs.filter(([name]) => name === String(key)).map(([, value]) => value);
  }

  has(key) {
    return this.pairs.some(([name]) => name === String(key));
  }

  set(key, value) {
    const at = this.pairs.findIndex(([name]) => name === String(key));
    if (at === -1) this.pairs.push([String(key), String(value)]);
    else this.pairs[at][1] = String(value);
  }

  append(key, value) {
    this.pairs.push([String(key), String(value)]);
  }

  delete(key) {
    this.pairs = this.pairs.filter(([name]) => name !== String(key));
  }

  forEach(callback) {
    this.pairs.forEach(([name, value]) => callback(value, name));
  }

  toString() {
    return this.pairs
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
  }
}

class ShimUrl {
  constructor(input, base) {
    let text = String(input);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
      const root = String(base || 'https://example.test/');
      const anchor = root.slice(0, root.lastIndexOf('/') + 1);
      text = text.startsWith('/')
        ? `${new ShimUrl(root).origin}${text}`
        : `${anchor}${text}`;
    }

    const match = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text);
    if (!match) throw new TypeError(`Invalid URL: ${input}`);

    this.protocol = match[1];
    this.host = match[2];
    this.hostname = match[2].split(':')[0];
    this.port = match[2].split(':')[1] || '';
    this.pathname = match[3] || '/';
    this.hash = match[5] || '';
    this.searchParams = new ShimSearchParams(match[4] || '');
  }

  get search() {
    const query = this.searchParams.toString();
    return query ? `?${query}` : '';
  }

  get origin() {
    return `${this.protocol}//${this.host}`;
  }

  get href() {
    return `${this.origin}${this.pathname}${this.search}${this.hash}`;
  }

  toString() {
    return this.href;
  }

  static createObjectURL() {
    return 'blob:shim';
  }

  static revokeObjectURL() {}
}

/* ------------------------------------------------------------------ */
/* installation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a document from an HTML file and install the browser globals.
 *
 * @param {string} html   file contents
 * @param {object} config { url, readFile, root } — readFile backs fetch()
 * @returns {object} handle with { document, window, errors, timers, storage }
 */
export function installDom(html, config = {}) {
  const nodes = parseFragment(html);
  const documentElement =
    nodes.find((node) => node instanceof Element && node.tagName === 'html') ||
    new Element('html');

  const head =
    documentElement.querySelector('head') || documentElement.appendChild(new Element('head'));
  const body =
    documentElement.querySelector('body') || documentElement.appendChild(new Element('body'));

  const errors = [];
  const timers = [];
  let clock = 0;

  const document = new Element('#document');
  document.appendChild(documentElement);
  document.documentElement = documentElement;
  document.head = head;
  document.body = body;

  document.createElement = (tagName) => new Element(tagName);
  document.createTextNode = (data) => new TextNode(data);
  document.createDocumentFragment = () => new DocumentFragment();
  document.getElementById = (id) =>
    documentElement.descendants().find((element) => element.getAttribute('id') === id) || null;

  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };

  const url = new ShimUrl(config.url || 'https://example.test/index.html');

  const window = {
    document,
    location: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      origin: url.origin,
      reload() {},
      assign() {},
    },
    history: {
      replaceState() {},
      pushState() {},
      back() {},
    },
    localStorage,
    navigator: {
      userAgent: 'jsc-dom-shim',
      language: 'en-US',
      languages: ['en-US'],
      clipboard: { writeText: () => Promise.resolve() },
      // Absent on purpose: 'serviceWorker' in navigator must be false so the
      // offline module short-circuits instead of reaching for a worker.
      storage: { estimate: () => Promise.resolve({ usage: 0, quota: 0 }) },
    },
    isSecureContext: false,
    devicePixelRatio: 2,
    innerWidth: 390,
    innerHeight: 844,
    matchMedia: (query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (callback) => {
      timers.push({ at: clock, callback, id: timers.length + 1 });
      return timers.length;
    },
    cancelAnimationFrame() {},
    print() {},
    alert(message) {
      errors.push(`alert(): ${message}`);
    },
    confirm: () => false,
    prompt: () => null,
    open: () => null,
    scrollTo() {},
    addEventListener(type, handler) {
      document.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      document.removeEventListener(type, handler);
    },
    dispatchEvent(event) {
      return document.dispatchEvent(event);
    },
  };

  const setTimeout = (callback, delay = 0) => {
    const id = timers.length + 1;
    timers.push({ at: clock + Number(delay || 0), callback, id });
    return id;
  };
  const clearTimeout = (id) => {
    const found = timers.find((timer) => timer.id === id);
    if (found) found.cancelled = true;
  };

  const globals = {
    window,
    document,
    localStorage,
    navigator: window.navigator,
    location: window.location,
    self: window,
    globalThis: window,
    setTimeout,
    clearTimeout,
    setInterval: setTimeout,
    clearInterval: clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    getComputedStyle: window.getComputedStyle,
    matchMedia: window.matchMedia,
    Element,
    Node,
    Event: SyntheticEvent,
    CustomEvent: SyntheticEvent,
    MouseEvent: SyntheticEvent,
    PointerEvent: SyntheticEvent,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Path2D: class {
      moveTo() {}
      lineTo() {}
      closePath() {}
      arc() {}
    },
    Blob: class {
      constructor(parts) {
        this.parts = parts || [];
        this.size = this.parts.join('').length;
      }
    },
    FileReader: class {
      readAsText() {
        this.result = '';
        this.onload?.();
      }
    },
    URL: ShimUrl,
    URLSearchParams: ShimSearchParams,
    history: window.history,
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    fetch: makeFetch(config, errors),
    L: makeLeaflet(document),
  };

  Object.entries(globals).forEach(([name, value]) => {
    if (name === 'globalThis') return;
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    // In a browser `window` *is* the global object. Code here reaches for both
    // spellings — `window.L` while waiting for Leaflet, bare `fetch` elsewhere —
    // so the two have to agree or a poll on window.L would never resolve.
    if (!(name in window)) window[name] = value;
  });

  return {
    document,
    window,
    errors,
    storage,
    /** Run due timers until the queue drains, so setTimeout-based code finishes. */
    async drain(rounds = 40) {
      for (let round = 0; round < rounds; round += 1) {
        // Let pending promises settle between timer rounds.
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
        const due = timers.filter((timer) => !timer.cancelled && !timer.ran);
        if (!due.length) continue;
        clock += 60;
        due.forEach((timer) => {
          timer.ran = true;
          try {
            timer.callback();
          } catch (error) {
            errors.push(`timer: ${error && error.message ? error.message : error}`);
          }
        });
      }
    },
  };
}

/** fetch() backed by the real files on disk, resolved from the repo root. */
function makeFetch(config, errors) {
  const read = config.readFile;
  return (path) => {
    const clean = String(path).split('?')[0].split('#')[0];
    try {
      const text = read(clean);
      if (text === null || text === undefined) throw new Error('not found');
      return Promise.resolve({
        ok: true,
        status: 200,
        url: clean,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(JSON.parse(text)),
      });
    } catch (error) {
      errors.push(`fetch 404: ${clean}`);
      return Promise.resolve({
        ok: false,
        status: 404,
        url: clean,
        text: () => Promise.resolve(''),
        json: () => Promise.reject(new Error(`404 ${clean}`)),
      });
    }
  };
}

/**
 * Leaflet stub covering exactly the API surface assets/js/ui/map.js touches.
 * Every call is recorded so tests can assert a track was actually drawn.
 */
function makeLeaflet(document) {
  const record = { maps: 0, tileLayers: 0, polylines: [], markers: [], fitBounds: 0 };

  class Layer {
    addTo(map) {
      map.layers.add(this);
      return this;
    }
    on() {
      return this;
    }
    bindTooltip() {
      return this;
    }
    bindPopup() {
      return this;
    }
    bringToFront() {
      return this;
    }
    setStyle() {
      return this;
    }
    setLatLng() {
      return this;
    }
    remove() {
      return this;
    }
  }

  class TileLayer extends Layer {}

  const L = {
    record,
    TileLayer,
    map(element) {
      record.maps += 1;
      const map = {
        layers: new Set(),
        scrollWheelZoom: { enable() {}, disable() {} },
        on() {
          return map;
        },
        off() {
          return map;
        },
        addLayer(layer) {
          map.layers.add(layer);
          return map;
        },
        removeLayer(layer) {
          map.layers.delete(layer);
          return map;
        },
        eachLayer(callback) {
          map.layers.forEach(callback);
          return map;
        },
        fitBounds() {
          record.fitBounds += 1;
          return map;
        },
        setView() {
          return map;
        },
        invalidateSize() {
          return map;
        },
        getContainer: () => element,
      };
      return map;
    },
    tileLayer(url, options) {
      record.tileLayers += 1;
      const layer = new TileLayer();
      layer.url = url;
      layer.options = options;
      return layer;
    },
    polyline(latLngs, options) {
      const layer = new Layer();
      layer.latLngs = latLngs;
      layer.options = options;
      record.polylines.push(layer);
      return layer;
    },
    marker(latLng, options) {
      const layer = new Layer();
      layer.latLng = latLng;
      layer.options = options;
      record.markers.push(layer);
      return layer;
    },
    divIcon: (options) => ({ options }),
    latLngBounds: (latLngs) => ({ latLngs, pad: () => ({ latLngs }) }),
    latLng: (lat, lon) => ({ lat, lon }),
    layerGroup: () => new Layer(),
    control: {
      scale: () => ({ addTo: () => ({}) }),
      attribution: () => ({ addTo: () => ({}) }),
    },
    DomUtil: { create: (tag) => document.createElement(tag) },
  };

  return L;
}

export { Element, TextNode, SyntheticEvent };
