import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:brightness-105",
        secondary: "border border-line bg-panel-raised text-paper hover:bg-panel",
        danger: "bg-danger text-white hover:brightness-105",
        ghost: "text-paper hover:bg-panel-raised",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={asChild ? undefined : "button"}
      className={cn(buttonVariants({ variant }), className)}
      {...props}
    />
  );
}
