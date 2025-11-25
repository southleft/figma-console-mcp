/**
 * Button Component
 *
 * A production-style React component using CSS modules and design tokens.
 * This represents what a Code Scanner would need to parse.
 */

import React from 'react';
import styles from './button.module.css';

interface ButtonProps {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  onClick,
  disabled = false,
}) => {
  const classNames = [
    styles.button,
    styles[variant],
    styles[size],
    disabled && styles.disabled,
  ].filter(Boolean).join(' ');

  return (
    <button
      className={classNames}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
};

/**
 * USAGE EXAMPLES:
 *
 * <Button variant="primary" size="md">Get Started</Button>
 * <Button variant="secondary" size="sm">Learn More</Button>
 * <Button variant="primary" size="lg">Sign Up Now</Button>
 */
