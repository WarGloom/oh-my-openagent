import { CATEGORY_PROMPT_APPEND_RESOLVERS } from "./constants"
import { QUICK_VERIFICATION_BOUNDARY } from "../../shared/routine-verification-routing-policy"

function joinPromptSections(sections: Array<string | undefined>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => section !== undefined && section.length > 0)
    .join("\n\n")
}

export function resolveCategoryPromptAppendForModel(
  categoryName: string,
  actualModel: string | undefined,
  staticPromptAppend: string,
  userPromptAppend: string | undefined,
): string | undefined {
  const dynamicResolver = CATEGORY_PROMPT_APPEND_RESOLVERS[categoryName]
  const quickBoundary = categoryName === "quick" ? QUICK_VERIFICATION_BOUNDARY : undefined
  if (!dynamicResolver) {
    return joinPromptSections([staticPromptAppend, quickBoundary])
  }
  const dynamicBase = dynamicResolver(actualModel)
  return joinPromptSections([dynamicBase, userPromptAppend, quickBoundary])
}
