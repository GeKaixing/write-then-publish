import operator
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .nodes import expert_node, finalize_node


class PipelineState(TypedDict, total=False):
    request: dict
    config: dict
    plan: dict
    expert_tasks: list[dict]
    task: dict
    drafts: Annotated[list[dict], operator.add]
    combined: str
    review: dict
    revisions: int
    final: dict


def build_graph():
    builder = StateGraph(PipelineState)
    builder.add_node("expert", expert_node)
    builder.add_node("finalize", finalize_node)

    builder.add_edge(START, "expert")
    builder.add_edge("expert", "finalize")
    builder.add_edge("finalize", END)
    return builder.compile()
