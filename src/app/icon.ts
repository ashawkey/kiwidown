import { createElement } from 'lucide'
import type { IconNode } from 'lucide'

/*
 * Lucide icons as SVG elements.
 *
 * Icons are imported by name so the bundler keeps only the handful actually used — the
 * whole library is well over a thousand of them.
 */

export type { IconNode }

/**
 * Build an icon element.
 *
 * `aria-hidden` because every icon here sits inside a control that carries its own label;
 * without it a screen reader would announce the graphic as well as the name.
 */
export function icon(node: IconNode, size = 16): SVGElement {
  const svg = createElement(node, {
    width: String(size),
    height: String(size),
    'stroke-width': '1.75',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  svg.classList.add('app-icon')
  return svg
}

/**
 * An icon-only button.
 *
 * The visible content is a graphic, so the accessible name has to come from somewhere
 * else: `aria-label` provides it and `title` doubles as the hover tooltip. Both carry the
 * keyboard shortcut, since that's the main thing lost when a text label becomes an icon.
 */
export function iconButton(
  node: IconNode,
  label: string,
  onClick: () => void,
  options: { shortcut?: string } = {}
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'app-button app-button--icon'
  const description = options.shortcut ? `${label}  (${options.shortcut})` : label
  button.title = description
  button.setAttribute('aria-label', description)
  button.appendChild(icon(node))
  button.addEventListener('click', onClick)
  return button
}
