import * as React from "react";

export interface CardProps {
  title: string;
  elevated?: boolean;
  children?: React.ReactNode;
}

export function Card({ title, elevated = false, children }: CardProps) {
  return (
    <div
      className={elevated ? "card card-elevated" : "card"}
      style={{ borderColor: "#3b82f6" }}
    >
      <h3 style={{ color: "var(--color-blue-500)" }}>{title}</h3>
      {children}
    </div>
  );
}
