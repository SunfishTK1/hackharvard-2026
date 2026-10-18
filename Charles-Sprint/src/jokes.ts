// Used when Claude is unavailable, so First Light still never answers without a joke.
const JOKES = [
  "The Harvard Bridge is 364.4 Smoots plus one ear. Oliver Smoot later ran the International Organization for Standardization, which is the most MIT revenge arc possible.",
  "I crossed 13 billion light-years to get here. The slowest part was the B branch.",
  "Every September 1st, Storrow Drive peels the roof off a rental truck. Locals call it a moving day tradition. Insurers call it Storrowing.",
  "Head races are time trials, so nobody watching the Head of the Charles knows who's winning. It's the only sport that works exactly like the MBTA arrival boards.",
  "HackHarvard demo math: 35 hours of building, two minutes of demo, and the Wi-Fi was only there for the 35 hours.",
  "MIT names its majors and buildings with numbers, which is why a Course 6 kid in Building 32 can't give you directions to anything with a name.",
  "Coxswains are small people yelling at large people for three miles. Boston calls that a regatta; anywhere else it's a Sox game.",
  "The John Harvard statue has three lies on it, and the tourists still rub its foot for luck. That's the most honest review of Harvard admissions I've seen.",
  "The Big Dig opened nine years late and billions over budget. I've been traveling since the Big Bang and I still beat it.",
  "In Boston, a lawn chair in a shoveled parking spot is a legally binding document until April.",
  "At 4 a.m. every HackHarvard team discovers their AI wrapper has a wrapper.",
  "The Eliot Bridge turn at the Head of the Charles is where good steering goes to retire.",
];

export const randomJoke = () => JOKES[Math.floor(Math.random() * JOKES.length)]!;
