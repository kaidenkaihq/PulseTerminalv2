import next from "eslint-config-next/core-web-vitals";
const config = [
  ...next,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "data/**"] },
];
export default config;
