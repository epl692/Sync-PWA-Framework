/** Elements wrapped by the host expose their error boundary under this key; LiveElement reports render errors through it. */
export const VIEW_ERROR: unique symbol = Symbol.for('sync.view-error') as never;
