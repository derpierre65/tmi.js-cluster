CREATE TABLE tmi_cluster_supervisors (
	id VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
	options LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
	metrics LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
	last_ping_at TIMESTAMP NULL DEFAULT NULL,
	created_at TIMESTAMP NULL DEFAULT NULL,
	updated_at TIMESTAMP NULL DEFAULT NULL,
	deleted_at TIMESTAMP NULL DEFAULT NULL,
	PRIMARY KEY (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE tmi_cluster_supervisor_processes (
	id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
	supervisor_id VARCHAR(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
	state VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
	channels LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`channels`)),
	metrics LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metrics`)),
	last_ping_at TIMESTAMP NULL DEFAULT NULL,
	created_at TIMESTAMP NULL DEFAULT NULL,
	updated_at TIMESTAMP NULL DEFAULT NULL,
	PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;