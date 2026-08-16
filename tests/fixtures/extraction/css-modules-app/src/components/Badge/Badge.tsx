import * as React from "react";
import styles from "./Badge.module.css";

export interface BadgeProps {
  tone?: "info" | "success" | "warning";
  label: string;
}

export const Badge = ({ tone = "info", label }: BadgeProps) => {
  return <span className={`${styles.badge} ${styles[tone] ?? ""}`}>{label}</span>;
};
