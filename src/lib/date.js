function formatDate(date, format = 'Y-m-d H:i:s') {
	if (typeof date === 'string') {
		date = new Date(date);
	}

	const day = date.getDate();
	let out = '';
	let char;

	for (let i = 0; i < format.length; i++) {
		switch (format[i]) {
			// hours
			case 'a':
				// `am` or `pm`
				char = (date.getHours() > 11) ? 'pm' : 'am';

				break;
			case 'g':
				// `1` through `12`
				char = date.getHours();
				if (char === 0) {
					char = 12;
				}
				else if (char > 12) {
					char -= 12;
				}

				break;
			case 'h':
				// `01` through `12`
				char = date.getHours();
				if (char === 0) {
					char = 12;
				}
				else if (char > 12) {
					char -= 12;
				}

				char = ('0' + char.toString()).slice(-2);

				break;
			case 'A':
				// `AM` or `PM`
				char = (date.getHours() > 11) ? 'PM' : 'AM';

				break;
			case 'G':
				// `0` through `23`
				char = date.getHours();

				break;
			case 'H':
				// `00` through `23`
				char = date.getHours();
				char = ('0' + char.toString()).slice(-2);

				break;
			// minutes
			case 'i':
				// `00` through `59`
				char = date.getMinutes();

				if (char < 10) {
					char = '0' + char;
				}

				break;
			// seconds
			case 's':
				// `00` through `59`
				char = ('0' + date.getSeconds().toString()).slice(-2);

				break;
			// day
			case 'd':
				// `01` through `31`
				char = date.getDate();
				char = ('0' + char.toString()).slice(-2);

				break;
			case 'j':
				// `1` through `31`
				char = date.getDate();

				break;
			case 'S':
				char = '';

				if (day > 3 && day < 21) {
					char = 'th';
				}
				else {
					const chars = [ 'st', 'nd', 'rd' ];
					char = chars[(day % 10) - 1] || 'th';
				}

				break;
			// month
			case 'm':
				// `01` through `12`
				char = date.getMonth() + 1;
				char = ('0' + char.toString()).slice(-2);

				break;
			// M = Jan - Dec (required?)
			// year
			case 'Y':
				// Examples: `1988` or `2015`
				char = date.getFullYear();

				break;
			// escape sequence
			case '\\':
				char = '';

				if (i + 1 < format.length) {
					char = format[++i];
				}

				break;
			default:
				char = format[i];

				break;
		}

		out += char;
	}

	return out;
}

export {
	formatDate,
}