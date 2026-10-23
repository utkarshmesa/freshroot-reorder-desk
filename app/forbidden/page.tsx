import Link from "next/link";

export default function Forbidden() {
  return (
    <main>
      <h1>Not available for your role</h1>
      <p>This screen isn&apos;t part of your role. <Link href="/">Go to your main screen</Link>, or ask the IT admin if your role is wrong.</p>
    </main>
  );
}
