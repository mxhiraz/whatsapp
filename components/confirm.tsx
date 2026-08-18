'use client'

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface Props {
  /** What the button shows — an icon, a label, or both. */
  children: React.ReactNode
  title: string
  description: string
  confirmLabel: string
  /** Awaited. Anything it resolves to is ignored, so a mutation can be handed over as it is. */
  onConfirm: () => unknown
  /**
   * Hover text, for a consequence the label cannot carry. An icon-only button wants
   * `aria-label` instead: the confirmation dialog already explains what will happen,
   * so a tooltip repeating it is noise.
   */
  tooltip?: string
  /** Accessible name, required when `children` is an icon with no words. */
  'aria-label'?: string
  destructive?: boolean
  size?: React.ComponentProps<typeof Button>['size']
  variant?: React.ComponentProps<typeof Button>['variant']
  className?: string
  disabled?: boolean
}

/**
 * A button whose action is gated behind a real dialog instead of window.confirm —
 * the native one can't be styled, can't be themed, and looks like a browser error.
 */
/**
 * Makes a plain button sit in a dropdown menu as if it were a `DropdownMenuItem`.
 *
 * Destructive actions cannot be real menu items: Radix unmounts the menu the
 * instant an item is selected, which tears down the confirmation dialog before it
 * can open. The consequence was that button padding and icon gap did not match
 * the real items beside them, so the icons stepped in and out by a few pixels.
 * Anything rendered inside a menu that is not a `DropdownMenuItem` gets this.
 */
export const menuItemClass =
  'h-auto min-h-9 w-full justify-start gap-2 rounded-md px-2 py-1.5 text-sm font-normal sm:min-h-7'

export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel,
  onConfirm,
  tooltip,
  destructive,
  size = 'sm',
  variant = 'ghost',
  className,
  disabled,
  'aria-label': ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const trigger = (
    <Button
      size={size}
      variant={variant}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(destructive && 'text-muted-foreground hover:text-red-600 dark:hover:text-red-400', className)}
      onClick={() => setOpen(true)}
    >
      {children}
    </Button>
  )

  return (
    <>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}

      <AlertDialog open={open} onOpenChange={setOpen}>
        {/* A consequence written out in full is several lines at 320px wide, so the
            dialog scrolls rather than growing past a 667px-tall viewport. */}
        <AlertDialogContent className="max-h-[85dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className={destructive ? 'bg-red-600 text-white hover:bg-red-700' : undefined}
              onClick={async e => {
                e.preventDefault()
                setBusy(true)
                try {
                  await onConfirm()
                  setOpen(false)
                } catch {
                  // The write has already reported itself with a toast. Leave the
                  // dialog open so it can be tried again, and never let the
                  // rejection escape as an unhandled one.
                } finally {
                  setBusy(false)
                }
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
