import { Button } from "../components/ui/button";
import { Card } from "../components/Card";

export default function HomePage() {
  return (
    <main className="hero">
      <Card title="Welcome" elevated>
        <Button variant="outline" size="sm">
          Get started
        </Button>
        <Button variant="ghost">Learn more</Button>
        <Button variant="outline" size="lg">
          Docs
        </Button>
      </Card>
      <Card title="Pricing">
        <Button>Buy now</Button>
      </Card>
      <span style={{ color: "#22c55e" }}>Limited offer</span>
    </main>
  );
}
