import { forwardRef, useId, type ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export interface TextFieldProps extends ComponentPropsWithoutRef<"input"> {
  label: string;
  hint?: string;
  error?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, id, className, "aria-describedby": externalDescription, "aria-invalid": invalid, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const description = [externalDescription, hint && `${inputId}-hint`, error && `${inputId}-error`]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground">{label}</label>
      <input
        {...props}
        ref={ref}
        id={inputId}
        aria-describedby={description}
        aria-invalid={error ? true : invalid}
        className={cn(
          "min-h-11 w-full rounded-control border border-border bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          error && "border-destructive",
          className,
        )}
      />
      {hint && <p id={`${inputId}-hint`} className="text-sm text-muted-foreground">{hint}</p>}
      {error && <p id={`${inputId}-error`} className="text-sm font-medium text-destructive">{error}</p>}
    </div>
  );
});
