export * from "./types"

import { setTeamCoreLogger } from "@oh-my-opencode/team-core"

import { log } from "../../shared/logger"

setTeamCoreLogger(log)
