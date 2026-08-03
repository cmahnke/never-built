export interface TileLayerField {
  [fieldName: string]: "String" | "Number" | "Boolean";
}

export interface VectorLayerDefinition {
  id: string;
  fields: TileLayerField;
  minzoom: number;
  maxzoom: number;
}

export interface TileJsonMetadata {
  vector_layers: VectorLayerDefinition[];
}

export interface TileMetadata {
  name: string;
  description: string;
  attribution: string;
  version: string;
  type: string;
  format: string;
  bounds: string;
  center: string;
  minzoom: string;
  maxzoom: string;
  json: string | TileJsonMetadata;
  "planetiler:buildtime": string;
  "planetiler:githash": string;
  "planetiler:osm:osmosisreplicationseq": string;
  "planetiler:osm:osmosisreplicationtime": string;
  "planetiler:osm:osmosisreplicationurl": string;
  "planetiler:version": string;
  compression: string;
}
