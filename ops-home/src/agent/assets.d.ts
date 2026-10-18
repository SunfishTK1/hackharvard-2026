// Images imported by components; Vite gives back their URL.
declare module "*.png" {
  const src: string;
  export default src;
}
