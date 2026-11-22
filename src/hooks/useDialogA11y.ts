import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type DialogA11yOptions = {
  isOpen: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

/**
 * Keyboard contract for the app's overlay dialogs: Escape dismisses, focus enters
 * the dialog on open, Tab stays inside it, and focus returns to the trigger on close.
 * The container itself must carry tabIndex={-1} so it can receive initial focus.
 */
export function useDialogA11y({ isOpen, containerRef, onClose }: DialogA11yOptions) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    container.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only the dialog that currently holds focus reacts, so two overlays open at
      // once cannot both dismiss on a single Escape.
      if (!container.contains(document.activeElement)) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el === document.activeElement || el.offsetHeight > 0 || el.offsetWidth > 0);

      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, containerRef]);

  useEffect(() => {
    if (isOpen) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && opener.isConnected) opener.focus();
  }, [isOpen]);
}
