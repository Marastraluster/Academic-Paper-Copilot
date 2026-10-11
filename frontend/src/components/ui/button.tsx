import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,box-shadow,transform,filter] duration-300 ease-spring active:scale-[.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline:
          "border border-[var(--glass-line)] bg-[var(--glass)] shadow-[var(--glass-highlight)] hover:bg-[var(--glass-strong)]",
        ghost: "hover:bg-[var(--glass-hover)]",
        subtle: "text-muted-foreground hover:bg-[var(--glass-hover)] hover:text-foreground",
        /* The one call to action in a bar: accent glass with a coloured glow. */
        glow:
          "rounded-full bg-primary/90 px-3.5 text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.4),0_6px_18px_hsl(var(--primary)/.38)] hover:brightness-110 disabled:saturate-50",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 rounded-lg px-2.5 text-xs",
        lg: "h-9 px-4",
        icon: "h-9 w-9 rounded-xl [&_svg]:size-[18px]",
        "icon-sm": "h-8 w-8 rounded-xl [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
