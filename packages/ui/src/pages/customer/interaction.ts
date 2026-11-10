/**
 * Portal input modality. Touch keyboards must not turn a pointer interaction
 * into keyboard navigation; a physical Tab/arrow key must still show focus,
 * including on a phone or tablet with an attached keyboard.
 */
export function installCustomerInputModality(doc: Document): () => void {
  const root = doc.documentElement;
  const previous = root.getAttribute('data-astra-input');
  root.setAttribute('data-astra-input', 'keyboard');

  const pointer = () => root.setAttribute('data-astra-input', 'pointer');
  const keyboard = (event: KeyboardEvent) => {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const navigation = [
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Escape',
    ];
    const target = event.target as Element | null;
    const editing = target?.closest?.('input, textarea, [contenteditable]');
    if (navigation.includes(event.key) || (!editing && ['Enter', ' '].includes(event.key))) {
      root.setAttribute('data-astra-input', 'keyboard');
    }
  };

  doc.addEventListener('pointerdown', pointer, true);
  doc.addEventListener('touchstart', pointer, { capture: true, passive: true });
  doc.addEventListener('keydown', keyboard, true);
  return () => {
    doc.removeEventListener('pointerdown', pointer, true);
    doc.removeEventListener('touchstart', pointer, true);
    doc.removeEventListener('keydown', keyboard, true);
    if (previous === null) root.removeAttribute('data-astra-input');
    else root.setAttribute('data-astra-input', previous);
  };
}
