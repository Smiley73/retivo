// Rspack bundles faster than webpack. The other options are the defaults
// create-video generated: overwrite existing output files, premount sequences
// two seconds early, jpeg frames.
import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
