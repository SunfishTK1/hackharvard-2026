// Shape of GET /api/home. The server composes every sentence; the client only renders.

export type TagKind = "need" | "info";

export interface Change {
  when: string;
  text: string;
  where: string;
  tag: string;
  kind: TagKind;
  href?: string;
}

export interface WaitingItem {
  code: string;
  text: string;
  age: string;
}

export interface WaitingPerson {
  name: string;
  site: string;
  ageDays: number;
  typicalDays: number;
  items: WaitingItem[];
}

export interface WaitingGroup {
  title: string;
  summary: string;
  people: WaitingPerson[];
}

export interface PipelinePoint {
  signedOn: string; // local date, YYYY-MM-DD
  days: number;
  waiting: boolean;
}

export interface StatCard {
  label: string;
  value: string;
  note: string;
}

export interface BlindSpot {
  context: string;
  title: string;
  body: string;
  action: string;
  href?: string;
}

export interface StudyRow {
  short: string;
  meta: string;
  active: number;
  enrolled: number;
  consented: number;
  pending: number;
  withdrawn: number;
  lifecycle: string;
  consent: string;
  alerts: string;
  alertNote: string;
  waiting: string;
}

export interface HomeData {
  generatedAt: string;
  dateLabel: string;
  hero: { headline: [string, string]; body: string };
  changes: { heading: string; subheading: string; items: Change[] };
  waiting: {
    groups: WaitingGroup[];
    onParticipants: string;
    notStarted: string | null;
  };
  pipeline: {
    heading: string;
    body: string;
    typicalDays: number;
    today: string;
    points: PipelinePoint[];
    chartLabel: string;
    cards: StatCard[];
  };
  blindSpots: { cards: BlindSpot[]; dataQuality: string | null };
  studies: { heading: string; rows: StudyRow[] };
}
