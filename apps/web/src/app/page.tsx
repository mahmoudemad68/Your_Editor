import { productLabel } from "../presentation/product-label";

export default function HomePage() {
  return (
    <main>
      <h1>{productLabel()}</h1>
      <p>Foundation scaffold. Project UI arrives in a later story.</p>
    </main>
  );
}
