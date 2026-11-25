export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    class?: string
    text?: string
    attrs?: Record<string, string>
    children?: Array<Node | string>
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class) node.className = options.class
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value)
  }
  if (options.children) node.append(...options.children)
  else if (options.text !== undefined) node.textContent = options.text
  return node
}

export function externalLink(href: string, text: string, className?: string): HTMLAnchorElement {
  return el('a', {
    class: className,
    text,
    attrs: { href, target: '_blank', rel: 'noreferrer' },
  })
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const children: Array<Node | string> = [el('span', { text: label }), control]
  if (hint) children.push(el('small', { text: hint }))
  return el('label', { class: 'field', children })
}

export function input(options: { id?: string; value?: string; placeholder?: string; spellcheck?: boolean }): HTMLInputElement {
  const node = el('input', {
    attrs: {
      ...(options.id ? { id: options.id } : {}),
      ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      spellcheck: 'false',
      autocomplete: 'off',
    },
  })
  if (options.value !== undefined) node.value = options.value
  return node
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
