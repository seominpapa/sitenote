export async function ordinaryQuestionPlan({question}) {
  return {scope:'general',range:'topic',terms:question.slice(0,300),sameProject:false};
}
