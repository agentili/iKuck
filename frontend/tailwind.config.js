/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        porcelain: '#FAFBF7',
        ink: '#183028',
        basil: '#247A4A',
        tomato: '#D94C35',
        yolk: '#F2BE3E',
        sage: '#E1ECE4',
        primary: {
          DEFAULT: '#10b981',
          dark: '#059669',
          light: '#34d399',
        }
      },
      fontFamily: {
        sans: ['Bricolage Grotesque Variable', 'system-ui', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
