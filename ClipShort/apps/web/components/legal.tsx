import Link from "next/link";

export default function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="min-h-screen px-5 py-10"><div className="mx-auto max-w-3xl"><Link href="/" className="font-bold text-violet-700">← ClipShort</Link><article className="surface mt-8 rounded-2xl border bg-white p-7 shadow-soft sm:p-10"><h1 className="text-3xl font-black">{title}</h1><div className="prose prose-slate mt-6 max-w-none">{children}</div></article></div></main>;
}
