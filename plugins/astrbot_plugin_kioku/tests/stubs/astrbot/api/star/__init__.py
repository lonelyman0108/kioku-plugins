class Context:
    pass


class Star:
    def __init__(self, context: Context) -> None:
        self.context = context


def register(*_args, **_kwargs):
    return lambda cls: cls
