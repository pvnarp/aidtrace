// November 10 motion pass (docs/DESIGN_LANGUAGE.md section 3 rule 8). Next.js mounts a template again on every navigation, client links included,
// so the short page-in fade in style.css plays on each new page. The wrapper has no box styles of its own and changes no layout.
export default function Template({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="page-shell">{children}</div>;
}
