import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

const feedbackVariants = cva("flex items-start gap-2 border-l-2 px-3 py-2 text-sm", {
  variants: {
    variant: {
      info: "border-primary bg-accent text-foreground",
      success: "border-success bg-success-surface text-success",
      error: "border-destructive bg-destructive-surface text-destructive",
    },
  },
  defaultVariants: { variant: "info" },
});

export interface FeedbackMessageProps extends Omit<ComponentPropsWithoutRef<"div">, "role"> {
  variant?: NonNullable<VariantProps<typeof feedbackVariants>["variant"]>;
}

const icons = { info: Info, success: CircleCheck, error: CircleAlert };

export function FeedbackMessage({ variant = "info", className, children, ...props }: FeedbackMessageProps) {
  const Icon = icons[variant];
  return (
    <div {...props} role={variant === "error" ? "alert" : "status"} className={cn(feedbackVariants({ variant }), className)}>
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
