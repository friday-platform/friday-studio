"""Serialization: dataclass/dict/list → JSON-serializable Python objects."""

import dataclasses


def serialize_data(data: object) -> object:
    """Convert agent output data to a JSON-serializable Python object.

    - dict/list: pass-through
    - dataclass: dataclasses.asdict
    - str: pass-through
    """
    if dataclasses.is_dataclass(data) and not isinstance(data, type):
        return dataclasses.asdict(data)
    return data
