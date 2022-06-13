<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
    <meta name="description" content="">
    <title>tmi.js Cluster</title>

    <link rel="canonical" href="{{ request()->url() }}">

    <!-- Fonts & Core CSS -->
    <link href="{{ 'tmi-cluster.css' }}" rel="stylesheet">

    <!-- Theme -->
    <meta name="theme-color" content="#6441A4">
</head>
<body>
    <div id="app">
        @yield('content')

        <footer class="text-muted text-center mb-5">
            <small>
                Copyright &copy; {{ date('Y') }} derpierre65 & Contributors
            </small>
        </footer>
    </div>

    <script src="{{ 'tmi-cluster.js' }}"></script>
</body>
</html>