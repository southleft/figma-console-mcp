import * as React from "react";
import { Badge } from "./components/Badge/Badge";

export default function App() {
  return (
    <div>
      <Badge tone="info" label="New" />
      <Badge tone="success" label="Shipped" />
      <Badge tone="warning" label="Deprecated" />
    </div>
  );
}
