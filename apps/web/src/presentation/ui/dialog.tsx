import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "../cn";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-black/60" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border border-line bg-panel p-5 text-paper shadow-xl",
          )}
        >
          <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-2 text-sm text-muted">
              {description}
            </DialogPrimitive.Description>
          ) : null}
          <div className="mt-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
