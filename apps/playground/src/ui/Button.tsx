import type { ButtonHTMLAttributes, ReactElement } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}

/** Hand-built button: ≥44px touch target, ember primary, no library. */
export function Button({ variant = 'default', className, type, ...rest }: ButtonProps): ReactElement {
  const variantClass = variant === 'default' ? '' : ` btn-${variant}`;
  return <button type={type ?? 'button'} className={`btn${variantClass}${className ? ` ${className}` : ''}`} {...rest} />;
}
