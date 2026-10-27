export default function KitchenArtwork() {
  return <svg viewBox="0 0 480 400" role="img" aria-label="Illustrazione di un piatto di pasta con pomodorini e basilico" className="kitchen-artwork">
    <path d="M22 100L455 25 480 355 68 393Z" fill="var(--art-color-0)" />
    <path d="M56 95L112 388M98 84L154 381M141 74L197 375M185 64L240 366M228 54L284 357M273 44L327 350M316 35L370 343M360 26L414 336" stroke="var(--art-color-1)" strokeWidth="20" />
    <ellipse cx="246" cy="215" rx="155" ry="151" fill="var(--art-color-2)" opacity=".12" />
    <circle cx="238" cy="198" r="153" fill="var(--art-color-3)" />
    <circle cx="238" cy="198" r="125" fill="none" stroke="var(--art-color-4)" strokeWidth="2" />
    <circle cx="238" cy="198" r="108" fill="var(--art-color-5)" />
    {[0,1,2,3,4,5,6,7].map((n) => <path key={n} d={`M${162+n*12} 133 C${310-n*5} 100, ${132+n*12} 245, ${280+n*4} 263`} fill="none" stroke={n%2?'var(--art-color-6)':'var(--art-color-7)'} strokeWidth="10" strokeLinecap="round" />)}
    {[[171,155],[282,145],[306,215],[203,268],[160,220]].map(([x,y])=><g key={x}><circle cx={x} cy={y} r="19" fill="var(--art-color-8)"/><path d={`M${x-9} ${y-6}q9 -9 17 0`} fill="none" stroke="var(--art-color-9)" strokeWidth="4" strokeLinecap="round"/></g>)}
    <path d="M222 186Q170 127 204 120Q249 123 222 186M222 186Q276 123 279 162Q275 195 222 186M230 234Q273 266 273 230Q260 207 230 234" fill="var(--art-color-10)" />
    <path d="M54 116L72 289M40 116L46 155Q54 171 64 153L66 112M52 114L58 160" stroke="var(--art-color-2)" strokeWidth="7" fill="none" strokeLinecap="round" />
    <path d="M425 104Q398 169 415 192L430 293M425 104L415 192" stroke="var(--art-color-2)" strokeWidth="8" fill="none" strokeLinecap="round" />
  </svg>;
}
