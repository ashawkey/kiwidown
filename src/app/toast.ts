/**
 * Transient messages, and the one prompt that needs an answer (draft recovery).
 *
 * Deliberately not `alert()`: the recovery prompt appears during startup, and a modal
 * there blocks rendering behind it. Errors here are things the user asked for and didn't
 * get — a failed open, a declined write — so they need to be visible without being fatal.
 */

let current: HTMLElement | undefined

function dismiss(): void {
  current?.remove()
  current = undefined
}

export function toast(message: string, timeout = 6000): void {
  dismiss()
  const el = document.createElement('div')
  el.className = 'app-toast'
  el.setAttribute('role', 'status')
  el.textContent = message
  document.body.appendChild(el)
  current = el
  if (timeout > 0) setTimeout(() => el === current && dismiss(), timeout)
}

/** A message with an accept/decline pair. Resolves false if dismissed by timeout. */
export function askToast(
  message: string,
  acceptLabel: string,
  declineLabel: string,
  timeout = 20_000
): Promise<boolean> {
  dismiss()
  return new Promise((resolve) => {
    const el = document.createElement('div')
    el.className = 'app-toast'
    el.setAttribute('role', 'alertdialog')
    el.append(message)

    const settle = (value: boolean) => {
      if (el !== current) return
      dismiss()
      resolve(value)
    }

    const accept = document.createElement('button')
    accept.type = 'button'
    accept.textContent = acceptLabel
    accept.addEventListener('click', () => settle(true))

    const decline = document.createElement('button')
    decline.type = 'button'
    decline.textContent = declineLabel
    decline.addEventListener('click', () => settle(false))

    el.append(accept, decline)
    document.body.appendChild(el)
    current = el
    accept.focus()

    if (timeout > 0) setTimeout(() => settle(false), timeout)
  })
}

/** Report a failure to the user and the console; `error` may be undefined. */
export function reportError(message: string, error: unknown): void {
  if (error !== undefined) console.error(message, error)
  const detail = error instanceof Error ? ` ${error.message}` : ''
  toast(`${message}${detail}`)
}
