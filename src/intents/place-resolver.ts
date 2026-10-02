export interface PlaceCandidate {
  label: string;
  bbox: [number, number, number, number];
  confidence?: number;
  providerId?: string;
}

export interface PlaceResolver {
  forwardGeocode(place: string): Promise<PlaceCandidate[]>;
}
